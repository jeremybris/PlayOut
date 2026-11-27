// The overlay's media and music (docs/home-overlay.md, Media).
export { clearMusicCache, listMusic, MUSIC_EXTENSIONS, scanMusic } from './music-library'
export {
  createMusicHandler,
  MUSIC_SCHEME,
  MUSIC_SCHEME_NAME,
  musicTrackUrl,
  registerMusicProtocol,
  type MusicProtocolDeps
} from './music-protocol'
export {
  createMediaService,
  type MediaNative,
  type MediaService,
  type MediaServiceDeps
} from './media-service'
export * from './playlist'
