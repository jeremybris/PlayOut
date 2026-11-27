// Scrapers module entry point (docs/ARCHITECTURE.md §4.6): the metadata service, the image cache shared with the
// media:// protocol handler, and the keyless store/completion-time helpers.
export { createMetadataService, type MetadataServiceOptions } from './metadata-service'
export { createImageCache, MEDIA_SCHEME, MEDIA_URL_PREFIX, safeGameId } from './image-cache'
export {
  steamStoreScraper,
  steamCurrentPlayers,
  steamAchievements,
  steamAppIdOf
} from './steam-store'
export { gogScraper, gogProductIdOf } from './gog-api'
export { hltbLookup, type HltbTimes } from './hltb'
export type {
  ImageCache,
  MediaPolicy,
  MetadataDeps,
  MetadataService,
  ScrapedMedia,
  ScrapedResult,
  Scraper
} from './types'
