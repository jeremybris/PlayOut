// Art ids (docs/ARCHITECTURE.md §4.6 "Art pipeline", "Ids"): every id the local caches and direct sources can key
// on, collected once per game from `source` + `externalId`, the `extra` keys the providers and importers already
// write, and `metadata.sources`, so a GOG or Epic game a scraper matched to a Steam appid is looked up in the Steam
// caches too. ROMs carry `romSystemId` + `romName` for the ES-DE / Playnite media folders.
import { basename, extname } from 'path'
import type { Game } from '../../shared/types'
import type { ArtIds } from './types'

function text(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function appId(value: unknown): number | undefined {
  const s = text(value)
  if (!s || !/^\d+$/.test(s)) return undefined
  const n = Number(s)
  return n > 0 ? n : undefined
}

export function artIdsOf(game: Game): ArtIds {
  const extra = game.extra ?? {}
  const sources = game.metadata.sources ?? {}
  const ids: ArtIds = {}

  switch (game.source) {
    case 'steam':
      ids.steamAppId = appId(game.externalId)
      break
    case 'gog':
      ids.gogProductId = text(game.externalId)
      break
    case 'epic':
      ids.epicAppName = text(game.externalId)
      break
    case 'ea':
      ids.eaOfferId = text(game.externalId)
      break
    case 'xbox':
      ids.xboxStoreId = text(game.externalId)
      break
    case 'battlenet':
      ids.battlenetCode = text(game.externalId)
      break
    case 'ubisoft':
      ids.ubisoftId = text(game.externalId)
      break
    case 'rom': {
      ids.romSystemId = text(game.platformId)
      const file = game.romPath ?? game.externalId
      const name = basename(file.replace(/\\/g, '/'))
      ids.romName = text(name.slice(0, name.length - extname(name).length)) ?? text(name)
      // ES-DE mirrors a ROM's sub-folder in its media folders: media/ps2/covers/Favorites 1/Game.png.
      ids.romRelDir = text(
        game.externalId.replace(/\\/g, '/').split('/').filter(Boolean).slice(1, -1).join('/')
      )
      break
    }
    default:
      break
  }

  // `extra` keys written by providers/* and accounts/* (ARCHITECTURE.md §4.6); they win over the source id above
  // because they are the store's own canonical id (EA aliases, Xbox product ids).
  ids.steamAppId = appId(extra.steamAppId) ?? ids.steamAppId
  ids.gogProductId = text(extra.gogProductId) ?? ids.gogProductId
  ids.epicNamespace = text(extra.epicNamespace)
  ids.epicCatalogItemId = text(extra.epicCatalogItemId)
  ids.epicAppName = text(extra.epicAppName) ?? ids.epicAppName
  ids.eaOfferId = text(extra.eaOfferId) ?? ids.eaOfferId
  ids.xboxStoreId = text(extra.storeId) ?? ids.xboxStoreId
  ids.xboxTitleId = text(extra.titleId)
  ids.ubisoftId = text(extra.ubisoftId) ?? ids.ubisoftId

  // Scraper matches: a Steam appid or GOG id found for a non-store game opens that store's caches and CDN too.
  ids.steamAppId ??= appId(sources.steam)
  ids.gogProductId ??= text(sources.gog)
  ids.igdbId = text(sources.igdb)
  ids.steamGridDbId = text(sources.steamgriddb)

  for (const key of Object.keys(ids) as (keyof ArtIds)[])
    if (ids[key] === undefined) delete ids[key]
  return ids
}
