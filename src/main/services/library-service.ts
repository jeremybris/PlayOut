import {
  effectiveGame,
  gameMetadataKey,
  metadataLayers,
  withMetadataEdit,
  withoutMetadataEdit,
  type MetadataEdit,
  type MetadataEditField,
  type MetadataLayers
} from '../../shared/metadata-edit'
import { STORE_PLATFORMS } from '../../shared/platforms'
import type {
  Game,
  GameMedia,
  GameMetadata,
  GameUserData,
  GameUserPatch,
  LibrarySnapshot,
  MediaKind,
  OwnedGame,
  Platform,
  PlaySession,
  ScannedGame,
  SourceId,
  StoreSourceId
} from '../../shared/types'
import type { EventBus } from '../events'
import { installLaunchSpec } from '../installs/install-uri'
import type { MetadataCloudOverlay } from '../metadata-edits/cloud-overlay'
import { hostLayer, remoteEditKey, type RemoteMetadataEdits } from '../metadata-edits/remote-edits'
import type { LibraryStore } from '../store/library-store'
import type { SessionsStore } from '../store/sessions-store'
import { makeGameId } from '../util/ids'
import { sortTitle } from '../util/text'
import { tMain } from '../i18n'

/** A provider's local art file for one game; handed to the metadata service as a cover-lane seed (`ArtSeed`). */
export interface LocalMediaImport {
  gameId: string
  kind: Exclude<MediaKind, 'screenshot' | 'video'>
  path: string
}

export interface MergeResult {
  added: number
  updated: number
  removed: number
  newGameIds: string[]
  /** Local art reported by the provider; the caller passes it to `metadata.enqueue` as seeds. */
  localMedia: LocalMediaImport[]
}

export interface RemoteMediaImport {
  gameId: string
  kind: Exclude<MediaKind, 'screenshot' | 'video'>
  url: string
}

export interface MergeOwnedResult {
  added: number
  updated: number
  removed: number
  newGameIds: string[]
  /** Store art URLs for games whose media of that kind is still empty; the caller passes them to `metadata.enqueue` as seeds. */
  remoteMedia: RemoteMediaImport[]
}

/** One landed piece of art (or one URL that answered 404) for `setMediaBatch`. */
export interface MediaBatchItem {
  gameId: string
  kind: Exclude<MediaKind, 'screenshot'>
  /** The landed media:// URL; absent for a negative item (`missing`). */
  url?: string
  /** Which source supplied it (an `ArtSourceId`, or a scraper id). */
  source?: string
  /** 'small' marks a cover below 600x900 the full lane may upgrade; 'full' clears that marker. */
  quality?: 'small' | 'full'
  /**
   * A seed or direct URL that answered 404: appended to `metadata.sources['art:<kind>:missing']` so the next
   * import or start does not download it again (ARCHITECTURE.md §4.6 "Art pipeline").
   */
  missing?: string
}

/** How many 404ed URLs `art:<kind>:missing` remembers per kind (a Steam seed plus its fallback is two). */
const MISSING_URLS_KEPT = 8

/** The URLs recorded as missing for a game and kind (`art:<kind>:missing`, space-separated). */
export function missingArtUrls(game: Pick<Game, 'metadata'>, kind: MediaKind): string[] {
  const value = game.metadata.sources?.[`art:${kind}:missing`]
  return value ? value.split(' ').filter(Boolean) : []
}

export interface ActiveSession {
  sessionId: string
  gameId: string
  startedAt: string
}

/**
 * Called after the user saved (or removed part of) a game's metadata edit (setMetadataEdit / clearMetadataEdit), with
 * the game as shown (LibraryService.view), its cloud key and its whole local edit afterwards (empty: no edit left).
 * The metadata cloud publishes it (the owner) or suggests it (anyone else). Errors are logged, never thrown back.
 */
export type MetadataEditedHook = (
  game: Game,
  key: string | null,
  edit: MetadataEdit,
  change: MetadataEditChange
) => void | Promise<void>

/** What a save did: `set` = the fields saved (setMetadataEdit); `cleared` = the fields removed (clearMetadataEdit; undefined = all). */
export interface MetadataEditChange {
  set?: MetadataEdit
  cleared?: MetadataEditField[]
}

/** All reads and writes of the game library go through this service so that events are emitted consistently. */
export class LibraryService {
  constructor(
    private readonly store: LibraryStore,
    private readonly sessions: SessionsStore,
    private readonly events: EventBus
  ) {}

  private cloud: MetadataCloudOverlay | null = null
  private cloudOff: (() => void) | null = null
  private editedHook: MetadataEditedHook | null = null
  private remoteEdits: RemoteMetadataEdits | null = null
  private readonly remoteViewListeners = new Set<() => void>()
  private readonly favoriteListeners = new Set<(id: string) => void>()

  /**
   * Called after the user turned a game's favourite on or off here (updateGame with `byUser`), not after an import or
   * a favourite taken from a paired PC: the favourites sync (streaming/favorites-sync.ts) sends the change soon.
   */
  onUserFavorite(listener: (id: string) => void): () => void {
    this.favoriteListeners.add(listener)
    return () => this.favoriteListeners.delete(listener)
  }

  /**
   * The metadata cloud's corrections (main/metadata-edits/cloud-overlay.ts), laid over the scraped metadata of every
   * game shown (view). A change of the cloud emits `library:changed` for the games it touches.
   */
  setCloudOverlay(overlay: MetadataCloudOverlay | null): void {
    this.cloudOff?.()
    this.cloudOff = null
    this.cloud = overlay
    if (!overlay) return
    this.cloudOff = overlay.onChange((keys) => {
      const changed = new Set(keys)
      const gameIds = this.store
        .games()
        .filter((g) => {
          const key = gameMetadataKey(g)
          return key !== null && changed.has(key)
        })
        .map((g) => g.id)
      if (gameIds.length) this.events.emit('library:changed', { reason: 'metadata', gameIds })
      // Host-only games show the cloud too (viewRemote): the streaming service builds them again.
      this.notifyRemoteView()
    })
  }

  /**
   * The user's edits of host-only games (main/metadata-edits/remote-edits.ts), laid over the hosts' metadata
   * (viewRemote).
   */
  setRemoteMetadataEdits(edits: RemoteMetadataEdits | null): void {
    this.remoteEdits = edits
  }

  /**
   * Called when what a host-only game shows may have changed without a new offer (a saved edit, the cloud): the
   * streaming service builds the remote library again. Returns the unsubscribe.
   */
  onRemoteViewChange(listener: () => void): () => void {
    this.remoteViewListeners.add(listener)
    return () => {
      this.remoteViewListeners.delete(listener)
    }
  }

  private notifyRemoteView(): void {
    for (const listener of this.remoteViewListeners) {
      try {
        listener()
      } catch (err) {
        console.error('remote view listener failed', err)
      }
    }
  }

  /** A host game (as its host offers it) with the user's own edit of it, as a game with user data. */
  private remoteWithEdit(game: Game): Game {
    const base = hostLayer(game)
    const edit = this.remoteEdits?.get(base)
    return edit && Object.keys(edit).length
      ? { ...base, user: withMetadataEdit(base.user, edit) }
      : base
  }

  /**
   * A host-only game as PlayOut shows it: the host's metadata (its scraped layer here), the cloud's fields, then the
   * user's own edit of it (RemoteMetadataEdits), the same precedence as a local game (view).
   */
  viewRemote(game: Game): Game {
    const withEdit = this.remoteWithEdit(game)
    return effectiveGame(withEdit, this.remoteCloudFields(game))
  }

  /** A host-only game's three metadata layers (scraped = the host's), for the Edit sheet. */
  remoteMetadataLayers(game: Game): MetadataLayers {
    const withEdit = this.remoteWithEdit(game)
    return {
      ...metadataLayers(withEdit, this.remoteCloudFields(game)),
      key: this.remoteCloudKey(game)
    }
  }

  /**
   * A host-only game's cloud key: the host layer's gameMetadataKey, except for a game its host added by its .exe
   * (source 'manual'). The offer replaces that game's id with a stand-in hash (remote-library.ts offeredId), so its
   * key would be `manual-<hash>`, which no PC's copy of the game has: it gets nothing from the cloud and sends it
   * nothing.
   */
  private remoteCloudKey(game: Game): string | null {
    const base = hostLayer(game)
    return base.source === 'manual' ? null : gameMetadataKey(base)
  }

  /**
   * The cloud's fields for a host-only game (by remoteCloudKey). The host owner's own name for the game (its
   * titleOverride, the host layer's title) stays above the cloud's title, as clients show the name the host's owner
   * chose; the other fields come from the cloud as usual.
   */
  private remoteCloudFields(game: Game): MetadataEdit | undefined {
    const key = this.remoteCloudKey(game)
    const fields = key ? this.cloud?.get(key) : undefined
    if (!fields || fields.title === undefined || !game.user?.titleOverride?.trim()) return fields
    const rest = { ...fields }
    delete rest.title
    return Object.keys(rest).length ? rest : undefined
  }

  /**
   * The metadata cloud confirmed `fields` under `key` (the owner's write, MetadataCloudService.tidyLocalEdit): the
   * user's edit of host-only games stored under that key drops the fields with the same value, and the host cards are
   * built again. The title edit always stays: a host card whose host owner renamed the game never shows the cloud's
   * title (remoteCloudFields), so dropping it there would bring back the host owner's name.
   */
  tidyRemoteMetadataEdit(key: string, fields: MetadataEdit): void {
    const rest = { ...fields }
    delete rest.title
    if (!this.remoteEdits?.tidy(key, rest).length) return
    this.notifyRemoteView()
  }

  /** setMetadataEdit for a host-only game (`game` as its host offers it): the edit goes to RemoteMetadataEdits. */
  setRemoteMetadataEdit(
    game: Game,
    edit: MetadataEdit,
    clear?: readonly MetadataEditField[]
  ): Game {
    this.requireRemoteEdits().set(hostLayer(game), edit, clear)
    return this.afterRemoteMetadataEdit(game, {
      set: edit,
      ...(clear?.length ? { cleared: [...clear] } : {})
    })
  }

  /** clearMetadataEdit for a host-only game. */
  clearRemoteMetadataEdit(game: Game, fields?: readonly MetadataEditField[]): Game {
    this.requireRemoteEdits().clear(hostLayer(game), fields)
    return this.afterRemoteMetadataEdit(game, { cleared: fields ? [...fields] : undefined })
  }

  private requireRemoteEdits(): RemoteMetadataEdits {
    if (!this.remoteEdits) throw new Error(tMain('mainDelete.hostGamesReadOnly'))
    return this.remoteEdits
  }

  private afterRemoteMetadataEdit(game: Game, change: MetadataEditChange): Game {
    this.notifyRemoteView()
    const shown = this.viewRemote(game)
    // The cloud key only: a game without one (known only by its host's id, or a host's .exe-added game with its
    // stand-in key) is not shared with the cloud.
    const key = this.remoteCloudKey(game)
    if (key) this.callEditedHook(shown, key, this.remoteWithEdit(game), change)
    return shown
  }

  /**
   * A game this PC just got from a host (a downloaded ROM) takes the user's edit of the host's copy: each field this
   * PC's record has no edit of. The host copy's edit stays. Returns whether the record changed.
   */
  adoptRemoteMetadataEdit(localId: string, hostGameId?: string): boolean {
    const local = this.store.getGame(localId)
    if (!local || !this.remoteEdits?.size) return false
    const edit = this.remoteEdits.forLocal(local, hostGameId)
    if (!edit) return false
    const mine = metadataLayers(local).local
    const take: MetadataEdit = {}
    for (const [field, value] of Object.entries(edit))
      if ((mine as Record<string, unknown>)[field] === undefined)
        (take as Record<string, unknown>)[field] = value
    if (!Object.keys(take).length) return false
    const game = this.store.patch(localId, (g) => {
      g.user = withMetadataEdit(g.user, take)
    })
    if (!game) return false
    this.events.emit('library:changed', { reason: 'update', gameIds: [localId] })
    return true
  }

  /** The store key of a host-only game's edit (remote-edits.ts remoteEditKey). */
  remoteEditKey(game: Game): string | null {
    return remoteEditKey(hostLayer(game))
  }

  /** The hook called after a local metadata edit was saved (MetadataEditedHook); null removes it. */
  setMetadataEditedHook(hook: MetadataEditedHook | null): void {
    this.editedHook = hook
  }

  /** The cloud's fields for a game (by its key); undefined when the cloud has none. */
  cloudFields(game: Game): MetadataEdit | undefined {
    return this.cloud?.get(gameMetadataKey(game))
  }

  /**
   * The game as PlayOut shows it: the cloud's fields and the user's own edit laid over the scraped metadata
   * (shared/metadata-edit.ts effectiveGame). Every game that leaves the main process for the renderer (or a
   * streaming client) goes through this; the stored record keeps the scraped values.
   */
  view(game: Game): Game {
    return effectiveGame(game, this.cloudFields(game))
  }

  /** Every game as shown (view). */
  viewGames(): Game[] {
    return this.store.games().map((g) => this.view(g))
  }

  /** A game as shown (view); undefined when it does not exist. */
  getGameView(id: string): Game | undefined {
    const game = this.store.getGame(id)
    return game ? this.view(game) : undefined
  }

  /** The game's three metadata layers, for the Edit sheet. */
  metadataLayers(id: string): MetadataLayers {
    const game = this.requireGame(id)
    return metadataLayers(game, this.cloudFields(game))
  }

  /**
   * Save the user's corrections of a game's metadata: each field of `edit` replaces the same field of the local
   * edit (the title is `user.titleOverride`); the fields of `clear` lose theirs first. Returns the game as
   * shown; calls the edited hook once.
   */
  setMetadataEdit(id: string, edit: MetadataEdit, clear?: readonly MetadataEditField[]): Game {
    const game = this.store.patch(id, (g) => {
      const user = clear?.length ? withoutMetadataEdit(g.user, clear) : g.user
      g.user = withMetadataEdit(user, edit)
    })
    if (!game) throw new Error(`Unknown game ${id}`)
    return this.afterMetadataEdit(game, {
      set: edit,
      ...(clear?.length ? { cleared: [...clear] } : {})
    })
  }

  /** Remove the user's edit of `fields` (all of them when absent): those fall back to the cloud, else the scrapers. */
  clearMetadataEdit(id: string, fields?: readonly MetadataEditField[]): Game {
    const game = this.store.patch(id, (g) => {
      g.user = withoutMetadataEdit(g.user, fields)
    })
    if (!game) throw new Error(`Unknown game ${id}`)
    return this.afterMetadataEdit(game, { cleared: fields ? [...fields] : undefined })
  }

  private afterMetadataEdit(game: Game, change: MetadataEditChange): Game {
    this.events.emit('library:changed', { reason: 'update', gameIds: [game.id] })
    const shown = this.view(game)
    this.callEditedHook(shown, gameMetadataKey(game), game, change)
    return shown
  }

  /** The edited hook (MetadataEditedHook) with `withEdit`'s whole local edit; its errors are logged. */
  private callEditedHook(
    shown: Game,
    key: string | null,
    withEdit: Game,
    change: MetadataEditChange
  ): void {
    const hook = this.editedHook
    if (!hook) return
    const edit = metadataLayers(withEdit).local
    try {
      void Promise.resolve(hook(shown, key, edit, change)).catch((err: unknown) =>
        console.error('metadata edited hook failed', err)
      )
    } catch (err) {
      console.error('metadata edited hook failed', err)
    }
  }

  games(): Game[] {
    return this.store.games()
  }

  getGame(id: string): Game | undefined {
    return this.store.getGame(id)
  }

  requireGame(id: string): Game {
    const game = this.store.getGame(id)
    if (!game) throw new Error(`Unknown game ${id}`)
    return game
  }

  platforms(): Platform[] {
    return [...this.store.platforms()].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
    )
  }

  snapshot(): LibrarySnapshot {
    return {
      games: this.viewGames(),
      platforms: this.platforms(),
      generatedAt: new Date().toISOString()
    }
  }

  gameCountsByPlatform(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const g of this.games()) {
      if (!g.installed) continue
      counts[g.platformId] = (counts[g.platformId] ?? 0) + 1
    }
    return counts
  }

  registerPlatforms(platforms: Platform[]): void {
    if (!platforms.length) return
    this.store.transaction((d) => {
      for (const p of platforms) d.platforms[p.id] = p
    })
  }

  /**
   * Reconcile a provider's scan with the library. Existing games keep their user data, play time, metadata and media;
   * games of this source that were not reported are marked `installed: false` (when `markMissing`). A ROM that was not
   * reported is removed instead when nothing of it is worth keeping (never played, no sessions, no user state).
   * `keep` names games the scan did not look for (a ROM still in an old ROM folder): they are left as they are.
   */
  mergeScan(
    source: SourceId,
    scanned: ScannedGame[],
    options: { markMissing?: boolean; keep?: ReadonlySet<string> } = {}
  ): MergeResult {
    const markMissing = options.markMissing ?? true
    const keep = options.keep ?? new Set<string>()
    const now = new Date().toISOString()
    const result: MergeResult = { added: 0, updated: 0, removed: 0, newGameIds: [], localMedia: [] }
    const seen = new Set<string>()

    this.store.transaction((d) => {
      for (const s of scanned) {
        const id = makeGameId(s.source, s.externalId, s.platformId)
        if (seen.has(id)) continue
        seen.add(id)
        const existing = d.games[id]
        if (existing) {
          // Counted (and announced) only when a field moved: the tracker's confirming scans run every 10 s.
          const before = JSON.stringify(existing)
          existing.title = s.title
          existing.sortTitle = sortTitle(s.title)
          existing.platformId = s.platformId
          existing.installed = true
          existing.installDir = s.installDir ?? existing.installDir
          existing.exePath = s.exePath ?? existing.exePath
          existing.romPath = s.romPath ?? existing.romPath
          // Its file is back (restored from the Recycle Bin): an ordinary ROM card again.
          if (s.romPath) delete existing.romRemoved
          existing.launch = s.launch
          existing.tracking = s.tracking
          if (s.storePlaytimeMinutes !== undefined)
            existing.storePlaytimeMinutes = s.storePlaytimeMinutes
          if (s.lastPlayed && (!existing.lastPlayed || s.lastPlayed > existing.lastPlayed))
            existing.lastPlayed = s.lastPlayed
          if (s.extra) existing.extra = { ...existing.extra, ...s.extra }
          if (s.metadata && existing.metadataStatus === 'none')
            existing.metadata = { ...s.metadata, ...existing.metadata }
          if (JSON.stringify(existing) !== before) result.updated++
        } else {
          d.games[id] = {
            id,
            source: s.source,
            externalId: s.externalId,
            platformId: s.platformId,
            title: s.title,
            sortTitle: sortTitle(s.title),
            installed: true,
            installDir: s.installDir,
            exePath: s.exePath,
            romPath: s.romPath,
            launch: s.launch,
            tracking: s.tracking,
            hidden: false,
            favorite: false,
            playtimeMinutes: 0,
            storePlaytimeMinutes: s.storePlaytimeMinutes,
            lastPlayed: s.lastPlayed,
            playCount: 0,
            addedAt: now,
            metadata: s.metadata ? { ...s.metadata } : {},
            media: {},
            metadataStatus: 'none',
            user: {},
            extra: s.extra
          }
          result.added++
          result.newGameIds.push(id)
        }
        if (s.localMedia) {
          // Only kinds the game still lacks: the tracker's confirming scans would otherwise queue every installed
          // game of the source as a seed job every 10 s (as `mergeOwned` already filters its remote seeds).
          const game = d.games[id]
          for (const [kind, path] of Object.entries(s.localMedia)) {
            if (!path || kind === 'video') continue
            const k = kind as LocalMediaImport['kind']
            if (game.media[k] || game.user.customMedia?.[k]) continue
            result.localMedia.push({ gameId: id, kind: k, path })
          }
        }
      }
      if (markMissing) {
        for (const g of Object.values(d.games)) {
          if (g.source === source && g.installed && !seen.has(g.id) && !keep.has(g.id)) {
            // A card kept for its recompilation after its disc image went to the Recycle Bin: no file to find.
            if (g.romRemoved) continue
            // A ROM game whose file was moved away (into its recompilation's folder, say) while a recompilation of it
            // is installed: the card stays, not installed, and Play starts the recompilation (shared/recomp-play).
            const keptForRecomp = source === 'rom' && !!g.metadata.recomp?.installed.length
            // A ROM whose file is gone has nothing to reinstall: its card goes, unless it carries history the user
            // would miss (played, sessions, favourite, hidden, renamed, custom art), which stays as a greyed card.
            if (
              source === 'rom' &&
              !keptForRecomp &&
              g.playCount === 0 &&
              !hasUserState(g) &&
              this.sessions.forGame(g.id).length === 0
            ) {
              delete d.games[g.id]
              result.removed++
              continue
            }
            g.installed = false
            // Its measured size goes with the install: a reinstall, often into the same folder, is measured anew.
            delete g.installSize
            result.removed++
          }
        }
      }
    })

    if (result.added || result.updated || result.removed)
      this.events.emit('library:changed', { reason: 'scan' })
    return result
  }

  /**
   * Reconcile a store account's owned list with the library (ARCHITECTURE.md §4.8). Listed games get `owned`; a
   * game the manifest scan knows keeps its installed facts and title, an owned-only record is refreshed. A game of
   * this source that was `owned` and is no longer listed loses the flag, and is removed when it exists only because
   * of the account: never installed, no play count, no sessions, no user state (favorite, hidden, title override,
   * custom art) and no tracked install (`keepIds`). Installed scans never touch `owned`. `updated` counts records a
   * field of which moved, and `library:changed` fires only when something did.
   */
  mergeOwned(
    source: StoreSourceId,
    owned: OwnedGame[],
    options: { keepIds?: Set<string> } = {}
  ): MergeOwnedResult {
    const now = new Date().toISOString()
    const platformId = STORE_PLATFORMS[source].id
    const keepIds = options.keepIds ?? new Set<string>()
    const result: MergeOwnedResult = {
      added: 0,
      updated: 0,
      removed: 0,
      newGameIds: [],
      remoteMedia: []
    }
    const seen = new Set<string>()
    let cleared = 0

    const collectMedia = (game: Game, o: OwnedGame): void => {
      const urls: [RemoteMediaImport['kind'], string | undefined][] = [
        ['cover', o.coverUrl],
        ['hero', o.heroUrl],
        ['logo', o.logoUrl],
        ['icon', o.iconUrl]
      ]
      for (const [kind, url] of urls) {
        if (!url || game.media[kind] || game.user.customMedia?.[kind]) continue
        // A URL that answered 404 in an earlier run is not asked again (every launch re-imports the owned list).
        if (missingArtUrls(game, kind).includes(url)) continue
        result.remoteMedia.push({ gameId: game.id, kind, url })
      }
    }

    this.store.transaction((d) => {
      // Built once per merge: a lookup per owned game instead of a walk over the whole library for each of
      // thousands of them (that walk was ~5 s for a 10,000-game import).
      const aliases = aliasIndex(d.games, source)
      for (const o of owned) {
        const externalId = o.externalId.trim()
        if (!externalId) continue
        let id = makeGameId(source, externalId, platformId)
        // An installed record the provider keyed differently (EA: another content id of the same install, or the
        // offer id when installerdata.xml was missing) is the same game; never a second card for it.
        const alias = d.games[id] ? undefined : findAlias(aliases, externalId, o)
        if (alias) id = alias.id
        if (seen.has(id)) continue
        seen.add(id)
        const existing = d.games[id]
        if (existing) {
          const before = JSON.stringify(existing)
          existing.owned = true
          if (!existing.installed && o.title) {
            existing.title = o.title
            existing.sortTitle = sortTitle(o.title)
          }
          if (
            o.storePlaytimeMinutes !== undefined &&
            (existing.storePlaytimeMinutes === undefined ||
              existing.storePlaytimeMinutes < o.storePlaytimeMinutes)
          )
            existing.storePlaytimeMinutes = o.storePlaytimeMinutes
          if (o.lastPlayedAt && (!existing.lastPlayed || o.lastPlayedAt > existing.lastPlayed))
            existing.lastPlayed = o.lastPlayedAt
          // The store's own date (Steam's "Date Added to Library") replaces the day PlayOut first saw the game.
          if (o.acquiredAt && existing.addedAt !== o.acquiredAt) existing.addedAt = o.acquiredAt
          if (o.extra) existing.extra = { ...existing.extra, ...o.extra }
          if (existing.metadataStatus === 'none') seedMetadata(existing, o)
          collectMedia(existing, o)
          if (JSON.stringify(existing) !== before) result.updated++
        } else {
          const game: Game = {
            id,
            source,
            externalId,
            platformId,
            title: o.title || externalId,
            sortTitle: sortTitle(o.title || externalId),
            installed: false,
            owned: true,
            launch: installLaunchSpec(source, { externalId, extra: o.extra }),
            tracking: { mode: 'none' },
            hidden: false,
            favorite: false,
            playtimeMinutes: 0,
            storePlaytimeMinutes: o.storePlaytimeMinutes,
            lastPlayed: o.lastPlayedAt,
            playCount: 0,
            addedAt: o.acquiredAt ?? now,
            metadata: {},
            media: {},
            metadataStatus: 'none',
            user: {},
            extra: o.extra
          }
          seedMetadata(game, o)
          d.games[id] = game
          collectMedia(game, o)
          result.added++
          result.newGameIds.push(id)
        }
      }
      for (const g of Object.values(d.games)) {
        if (g.source !== source || g.owned !== true || seen.has(g.id)) continue
        g.owned = false
        cleared++
        if (
          !g.installed &&
          !g.installDir &&
          g.playCount === 0 &&
          !hasUserState(g) &&
          !keepIds.has(g.id) &&
          this.sessions.forGame(g.id).length === 0
        ) {
          delete d.games[g.id]
          result.removed++
        }
      }
    })

    if (result.added || result.updated || cleared)
      this.events.emit('library:changed', { reason: 'import' })
    return result
  }

  /**
   * `byUser`: the patch is the user's own (the renderer's updateGame), so a favourite turned on or off is stamped with
   * its time (`favoriteAt`, for the favourites sync with paired PCs). Main's own callers never stamp.
   */
  updateGame(id: string, patch: GameUserPatch, options: { byUser?: boolean } = {}): Game {
    let favoriteChanged = false
    const game = this.store.patch(id, (g) => {
      if (patch.favorite !== undefined && patch.favorite !== g.favorite && options.byUser) {
        // Strictly after the change kept (another PC's clock may have dated it a moment ahead).
        const before = g.favoriteAt ? Date.parse(g.favoriteAt) : NaN
        const at = Math.max(Date.now(), Number.isFinite(before) ? before + 1 : 0)
        g.favoriteAt = new Date(at).toISOString()
        favoriteChanged = true
      }
      if (patch.favorite !== undefined) g.favorite = patch.favorite
      if (patch.hidden !== undefined) g.hidden = patch.hidden
      // Optional flags are stored only while true, like `hiddenByStore`.
      if (patch.completed) g.completed = true
      else if (patch.completed === false) delete g.completed
      if (patch.user) {
        const user = { ...g.user }
        for (const [key, value] of Object.entries(patch.user) as [keyof GameUserData, unknown][]) {
          if (value === undefined) continue
          if (value === null || (key === 'preferredCopy' && value === false)) delete user[key]
          else if (key === 'customMedia')
            user.customMedia = {
              ...(g.user.customMedia ?? {}),
              ...(value as GameUserData['customMedia'])
            }
          else (user as Record<string, unknown>)[key] = value
        }
        g.user = user
      }
    })
    if (!game) throw new Error(`Unknown game ${id}`)
    this.events.emit('library:changed', { reason: 'update', gameIds: [id] })
    if (favoriteChanged)
      for (const listener of this.favoriteListeners) {
        try {
          listener(id)
        } catch {
          // A listener's failure is its own.
        }
      }
    return game
  }

  /**
   * A favourite taken from a paired PC (streaming/favorites-sync.ts): set with that change's time (`atMs`, on this
   * PC's clock; 0 = a favourite never changed since the sync came, kept without a time). Not a change of the user's
   * here: onUserFavorite is not called. False for an unknown game.
   */
  setSyncedFavorite(id: string, favorite: boolean, atMs: number): boolean {
    let changed = false
    const game = this.store.patch(id, (g) => {
      if (g.favorite !== favorite) changed = true
      g.favorite = favorite
      if (atMs > 0) g.favoriteAt = new Date(atMs).toISOString()
      else delete g.favoriteAt
    })
    if (!game) return false
    if (changed) this.events.emit('library:changed', { reason: 'update', gameIds: [id] })
    return true
  }

  /**
   * Follow the games a store's client has hidden. Only a change on the store's side moves `hidden`: a game newly hidden
   * there is hidden here, one shown again there is shown here. In between, the user's own choice here stands.
   */
  syncStoreHidden(source: SourceId, hiddenExternalIds: ReadonlySet<string>): number {
    let changed = 0
    this.store.transaction((d) => {
      for (const game of Object.values(d.games)) {
        if (game.source !== source) continue
        const hidden = hiddenExternalIds.has(game.externalId)
        if (hidden === Boolean(game.hiddenByStore)) continue
        if (game.hidden !== hidden) changed++
        game.hidden = hidden
        if (hidden) game.hiddenByStore = true
        else delete game.hiddenByStore
      }
    })
    if (changed) this.events.emit('library:changed', { reason: 'update' })
    return changed
  }

  /** Hand one kind back to the art pipeline. `updateGame` merges `customMedia`, so it cannot remove a kind. */
  clearCustomMedia(id: string, kind: keyof NonNullable<GameUserData['customMedia']>): Game {
    const game = this.store.patch(id, (g) => {
      const customMedia = { ...(g.user.customMedia ?? {}) }
      delete customMedia[kind]
      const user: GameUserData = { ...g.user, customMedia }
      if (!Object.keys(customMedia).length) delete user.customMedia
      g.user = user
    })
    if (!game) throw new Error(`Unknown game ${id}`)
    this.events.emit('library:changed', { reason: 'update', gameIds: [id] })
    return game
  }

  /**
   * Merge play state imported from another frontend (ES-DE gamelists): flags are only ever turned on, counters
   * and dates only grow, and the preferred emulator is only set when the user has not chosen one here.
   */
  applyImportedState(
    id: string,
    state: {
      favorite?: boolean
      hidden?: boolean
      playCount?: number
      playtimeMinutes?: number
      lastPlayed?: string
      emulatorId?: string
    }
  ): Game | undefined {
    let changed = false
    const game = this.store.patch(id, (g) => {
      if (state.favorite && !g.favorite) {
        g.favorite = true
        changed = true
      }
      if (state.hidden && !g.hidden) {
        g.hidden = true
        changed = true
      }
      if (state.playCount !== undefined && state.playCount > g.playCount) {
        g.playCount = state.playCount
        changed = true
      }
      if (state.playtimeMinutes !== undefined && state.playtimeMinutes > g.playtimeMinutes) {
        g.playtimeMinutes = state.playtimeMinutes
        changed = true
      }
      if (state.lastPlayed && (!g.lastPlayed || state.lastPlayed > g.lastPlayed)) {
        g.lastPlayed = state.lastPlayed
        changed = true
      }
      if (state.emulatorId && !g.user.emulatorId) {
        g.user = { ...g.user, emulatorId: state.emulatorId }
        changed = true
      }
    })
    if (game && changed) this.events.emit('library:changed', { reason: 'import', gameIds: [id] })
    return game
  }

  /**
   * A ROM converted to another file (Settings › Convert): its record moves to the new file's id, with everything on
   * it (play time, sessions, favourite, title, metadata, art). `mediaUrl` maps each media URL to the moved folder's.
   * The next scan fills in the launch details. Null when there is nothing to move (not a ROM, the new file already a
   * game of its own, or the same id).
   */
  rekeyRom(
    fromId: string,
    externalId: string,
    romPath: string,
    mediaUrl: (url: string) => string = (url) => url
  ): string | null {
    const old = this.store.getGame(fromId)
    if (!old || old.source !== 'rom') return null
    const toId = makeGameId('rom', externalId, old.platformId)
    if (toId === fromId || this.store.getGame(toId)) return null
    const moved: Game = structuredClone(old)
    moved.id = toId
    moved.externalId = externalId
    moved.romPath = romPath
    moved.installed = true
    delete moved.installSize
    // The new file is not what the old one was (a PS3 disc folder made into an ISO): its folder flags go, or Convert
    // would still offer folder conversions. The rescan that follows a conversion sets them again for a result that is
    // a folder (it merges what it finds into the record).
    if (moved.extra) {
      const extra = { ...(moved.extra as Record<string, unknown>) }
      delete extra.directory
      delete extra.ps3Kind
      delete extra.gameFolder
      moved.extra = extra as typeof moved.extra
    }
    const media = moved.media as Record<string, unknown>
    for (const [kind, value] of Object.entries(media)) {
      if (typeof value === 'string') media[kind] = mediaUrl(value)
      else if (Array.isArray(value))
        media[kind] = value.map((v: unknown) => (typeof v === 'string' ? mediaUrl(v) : v))
    }
    this.store.transaction((d) => {
      delete d.games[fromId]
      d.games[toId] = moved
    })
    this.sessions.rekey(fromId, toId)
    this.events.emit('library:changed', {
      reason: 'remove',
      gameIds: [fromId],
      movedTo: { [fromId]: toId }
    })
    this.events.emit('library:changed', { reason: 'scan', gameIds: [toId] })
    return toId
  }

  /**
   * A ROM game's disc image went to the Recycle Bin for its recompilation (main/recomp/image-offer.ts): the card stays
   * (play time, art, favourite) and starts the recompilation; its ROM path and measured size go, so nothing that works
   * on ROM files acts on it. Returns the game, or undefined when it is not a ROM of this PC.
   */
  markRomRemoved(
    id: string,
    recompId: string,
    at: string = new Date().toISOString()
  ): Game | undefined {
    const current = this.store.getGame(id)
    if (!current || current.source !== 'rom' || current.remote) return undefined
    const game = this.store.patch(id, (g) => {
      const romPath = g.romPath ?? g.romRemoved?.romPath ?? ''
      const launchRomPath =
        g.launch.kind === 'emulator' && g.launch.romPath
          ? g.launch.romPath
          : g.romRemoved?.launchRomPath
      const installSize = g.installSize ?? g.romRemoved?.installSize
      g.romRemoved = {
        at,
        recompId,
        romPath,
        // Kept so Restore (the recompilation's test run failed) puts the card back exactly as it was.
        ...(launchRomPath ? { launchRomPath } : {}),
        ...(installSize !== undefined ? { installSize } : {})
      }
      delete g.romPath
      delete g.installSize
      // Its launch names no file either (a rescan that finds the image again restores the launch from the scan).
      if (g.launch.kind === 'emulator') g.launch = { ...g.launch, romPath: '' }
    })
    if (game) this.events.emit('library:changed', { reason: 'update', gameIds: [id] })
    return game
  }

  /**
   * The disc image markRomRemoved recorded as gone is back at its path (Restore after the recompilation's test run,
   * main/recomp/service.ts): an ordinary ROM card again, with its ROM path, launch and size as before. Returns the
   * game, or undefined when it was not kept for a recompilation.
   */
  restoreRomRemoved(id: string): Game | undefined {
    const current = this.store.getGame(id)
    if (!current?.romRemoved || current.source !== 'rom' || current.remote) return undefined
    const game = this.store.patch(id, (g) => {
      const removed = g.romRemoved
      if (!removed) return
      if (removed.romPath) g.romPath = removed.romPath
      if (removed.installSize !== undefined) g.installSize = removed.installSize
      if (g.launch.kind === 'emulator' && !g.launch.romPath)
        g.launch = { ...g.launch, romPath: removed.launchRomPath ?? removed.romPath }
      delete g.romRemoved
    })
    if (game) this.events.emit('library:changed', { reason: 'update', gameIds: [id] })
    return game
  }

  removeGame(id: string): void {
    if (this.store.remove(id))
      this.events.emit('library:changed', { reason: 'remove', gameIds: [id] })
  }

  /**
   * A card for a recompilation whose original game is not in the library (shared/recomp-play recompOnlyKey): a ROM card
   * of the original's system with no game file (not installed), so Play starts the recompilation. Its id comes from
   * the recompilation title, so the same game gets the same card back. Null when that card is already there.
   */
  addRecompGame(input: {
    titleKey: string
    title: string
    platformId: string
    recomp: NonNullable<GameMetadata['recomp']>
  }): Game | null {
    const externalId = `Recompilations/${input.titleKey}`
    const id = makeGameId('rom', externalId, input.platformId)
    if (this.store.getGame(id)) return null
    const game: Game = {
      id,
      source: 'rom',
      externalId,
      platformId: input.platformId,
      title: input.title,
      sortTitle: sortTitle(input.title),
      installed: false,
      launch: { kind: 'emulator', systemId: input.platformId, romPath: '' },
      tracking: { mode: 'spawned' },
      hidden: false,
      favorite: false,
      playtimeMinutes: 0,
      playCount: 0,
      addedAt: new Date().toISOString(),
      metadata: { recomp: input.recomp },
      media: {},
      metadataStatus: 'none',
      user: {},
      extra: { recompOnly: input.titleKey }
    }
    this.store.upsert(game)
    this.events.emit('library:changed', { reason: 'scan', gameIds: [id] })
    return game
  }

  /**
   * A recompilation the user added from the recompilations browser (Add to library): its own card, not installed, kept
   * until the user removes it (whatever else is in the library). Its text comes from the catalog (the scrapers would
   * look the project's name up as a game). The existing card when it is there already.
   */
  addRecompEntryGame(input: {
    recompId: string
    title: string
    platformId: string
    recomp: NonNullable<GameMetadata['recomp']>
    favorite: boolean
    description: string
    developer: string
  }): Game {
    const externalId = `Recompilations/added/${input.recompId}`
    const id = makeGameId('rom', externalId, input.platformId)
    const existing = this.store.getGame(id)
    if (existing) return existing
    const now = new Date().toISOString()
    const game: Game = {
      id,
      source: 'rom',
      externalId,
      platformId: input.platformId,
      title: input.title,
      sortTitle: sortTitle(input.title),
      installed: false,
      launch: { kind: 'emulator', systemId: input.platformId, romPath: '' },
      tracking: { mode: 'spawned' },
      hidden: false,
      favorite: input.favorite,
      ...(input.favorite ? { favoriteAt: now } : {}),
      playtimeMinutes: 0,
      playCount: 0,
      addedAt: now,
      metadata: {
        recomp: input.recomp,
        ...(input.description ? { description: input.description } : {}),
        ...(input.developer ? { developers: [input.developer] } : {})
      },
      media: {},
      metadataStatus: 'done',
      user: {},
      extra: { recompAdded: input.recompId }
    }
    this.store.upsert(game)
    this.events.emit('library:changed', { reason: 'scan', gameIds: [id] })
    return game
  }

  /**
   * A recompilation's own card whose original game is now in the library: its play history (sessions, play time,
   * plays, last played, favourite) moves to the original's card and the recompilation's card goes. False when either
   * card is missing.
   */
  absorbGame(fromId: string, intoId: string): boolean {
    const from = this.store.getGame(fromId)
    if (!from || fromId === intoId || !this.store.getGame(intoId)) return false
    this.store.transaction((d) => {
      const into = d.games[intoId]
      if (!into) return
      into.playtimeMinutes = (into.playtimeMinutes ?? 0) + (from.playtimeMinutes ?? 0)
      into.playCount = (into.playCount ?? 0) + (from.playCount ?? 0)
      if (from.lastPlayed && (!into.lastPlayed || from.lastPlayed > into.lastPlayed))
        into.lastPlayed = from.lastPlayed
      if (from.favorite && !into.favorite) {
        into.favorite = true
        if (from.favoriteAt) into.favoriteAt = from.favoriteAt
      }
      if (from.completed && !into.completed) into.completed = from.completed
      // The player's own settings on the card go along where the original has none (its custom art stays behind: it
      // lives in the card's own image folder).
      const user = from.user ?? {}
      const target = (into.user ??= {})
      if (user.titleOverride && !target.titleOverride) target.titleOverride = user.titleOverride
      if (user.notes) target.notes = target.notes ? `${target.notes}\n\n${user.notes}` : user.notes
      if (user.performance && !target.performance) target.performance = user.performance
      if (user.playlist?.length && !target.playlist?.length) target.playlist = user.playlist
      if (user.metadataEdits && !target.metadataEdits) target.metadataEdits = user.metadataEdits
      delete d.games[fromId]
    })
    this.sessions.rekey(fromId, intoId)
    this.events.emit('library:changed', {
      reason: 'remove',
      gameIds: [fromId],
      movedTo: { [fromId]: intoId }
    })
    this.events.emit('library:changed', { reason: 'update', gameIds: [intoId] })
    return true
  }

  /**
   * Merge scraped metadata/media into a game. Fields already present are only replaced when `overwrite`;
   * `metadata.sources` is merged unless `replaceSources` (a user-chosen match drops the previous match's ids).
   */
  applyMetadata(
    id: string,
    update: {
      title?: string
      metadata?: Partial<GameMetadata>
      media?: Partial<GameMedia>
      status?: Game['metadataStatus']
    },
    options: {
      overwrite?: boolean
      replaceSources?: boolean
      reason?: 'metadata' | 'import'
      /** Write without `library:changed`: the caller coalesces its own events (the full lane's per-game writes). */
      quiet?: boolean
    } = {}
  ): Game {
    const overwrite = options.overwrite ?? false
    const game = this.store.patch(id, (g) => {
      if (update.title && (overwrite || !g.title)) {
        g.title = update.title
        g.sortTitle = sortTitle(update.title)
      }
      if (update.metadata) {
        const next: GameMetadata = { ...g.metadata }
        for (const [key, value] of Object.entries(update.metadata) as [
          keyof GameMetadata,
          unknown
        ][]) {
          if (value === undefined || value === null) continue
          if (Array.isArray(value) && value.length === 0) continue
          const current = next[key]
          const empty =
            current === undefined ||
            current === null ||
            (Array.isArray(current) && current.length === 0) ||
            current === ''
          if (overwrite || empty) (next as Record<string, unknown>)[key] = value
        }
        if (options.replaceSources) next.sources = { ...(update.metadata.sources ?? {}) }
        else if (update.metadata.sources)
          next.sources = { ...g.metadata.sources, ...update.metadata.sources }
        next.updatedAt = new Date().toISOString()
        g.metadata = next
      }
      if (update.media) {
        for (const [kind, url] of Object.entries(update.media) as [
          keyof GameMedia,
          string | string[] | undefined
        ][]) {
          if (url === undefined) continue
          const custom = kind !== 'screenshots' && kind !== 'video' && g.user.customMedia?.[kind]
          if (custom) continue
          if (
            overwrite ||
            !g.media[kind] ||
            (Array.isArray(g.media[kind]) && (g.media[kind] as string[]).length === 0)
          ) {
            ;(g.media as Record<string, unknown>)[kind] = url
          }
        }
      }
      if (update.status) g.metadataStatus = update.status
    })
    if (!game) throw new Error(`Unknown game ${id}`)
    if (!options.quiet)
      this.events.emit('library:changed', { reason: options.reason ?? 'metadata', gameIds: [id] })
    return game
  }

  /** Remove one metadata field (a Co-Op handler that no longer fits the game); quiet: no `library:changed`. */
  clearMetadataField(
    id: string,
    key: keyof GameMetadata,
    options: { quiet?: boolean } = {}
  ): boolean {
    const game = this.getGame(id)
    if (!game || game.metadata[key] === undefined) return false
    this.store.patch(id, (g) => {
      const next = { ...g.metadata }
      delete next[key]
      g.metadata = next
    })
    if (!options.quiet) this.events.emit('library:changed', { reason: 'metadata', gameIds: [id] })
    return true
  }

  /**
   * Set the measured install size of several games in one write and one `library:changed` (install-size.ts measures a
   * whole library after a scan). Unchanged sizes are skipped; returns the ids that changed.
   */
  setInstallSizes(
    items: readonly { id: string; size: NonNullable<Game['installSize']> }[]
  ): string[] {
    const changed: string[] = []
    for (const { id, size } of items) {
      const game = this.getGame(id)
      if (!game) continue
      const current = game.installSize
      const same =
        !!current &&
        current.bytes === size.bytes &&
        current.how === size.how &&
        current.path === size.path &&
        !!current.unmeasurable === !!size.unmeasurable
      // Nothing new: no write at all. A re-walk with the same result only moves measuredAt (the week starts again),
      // written quietly.
      if (same && (current.how === 'store' || current.measuredAt === size.measuredAt)) continue
      this.store.patch(id, (g) => {
        g.installSize = { ...size }
      })
      if (!same) changed.push(id)
    }
    if (changed.length) this.events.emit('library:changed', { reason: 'update', gameIds: changed })
    return changed
  }

  /**
   * Forget a game's measured size (the recompilation it was played from, and measured by, is gone). Announced when it
   * had one; returns whether it did.
   */
  clearInstallSize(id: string): boolean {
    if (!this.getGame(id)?.installSize) return false
    this.store.patch(id, (g) => {
      delete g.installSize
    })
    this.events.emit('library:changed', { reason: 'update', gameIds: [id] })
    return true
  }

  /**
   * Forget the achievement counts of `ids` (and the RetroAchievements match, which only the counts use): the
   * account they came from was signed out. Quiet; returns the ids that changed for the caller to announce.
   */
  clearAchievements(ids: readonly string[], sourceKey?: string): string[] {
    const changed: string[] = []
    for (const id of ids) {
      this.store.patch(id, (g) => {
        if (!g.metadata.achievements && !(sourceKey && g.metadata.sources?.[sourceKey])) return
        const next: GameMetadata = { ...g.metadata }
        delete next.achievements
        if (sourceKey && next.sources?.[sourceKey]) {
          next.sources = { ...next.sources }
          delete next.sources[sourceKey]
        }
        g.metadata = next
        changed.push(id)
      })
    }
    return changed
  }

  /**
   * Set several media URLs in one transaction and one `library:changed` (the cover lane lands hundreds of
   * covers; one event per cover would make the renderer refetch the snapshot continuously). An item's `source`
   * is recorded as `metadata.sources['art:<kind>']` for the detail panel's attribution and `quality` as
   * `metadata.sources['art:<kind>:quality']` ('small' for a 300x450 cover the full lane may still upgrade;
   * 'full' clears the marker), all in the same transaction (ARCHITECTURE.md §4.6 "Art pipeline"). A kind the
   * user has custom art for is left alone, as `applyMetadata` does: the download may have been in flight when
   * the user chose the file. A negative item (`missing`) only records the URL under `art:<kind>:missing`.
   * Returns the ids of the games that changed; with `quiet` the caller announces them itself.
   */
  setMediaBatch(items: MediaBatchItem[], options: { quiet?: boolean } = {}): string[] {
    const touched: string[] = []
    this.store.transaction((d) => {
      for (const item of items) {
        const g = d.games[item.gameId]
        if (!g) continue
        if (g.user.customMedia?.[item.kind]) continue
        let changed = false
        if (item.missing) {
          const known = missingArtUrls(g, item.kind)
          if (!known.includes(item.missing)) {
            const sources = { ...(g.metadata.sources ?? {}) }
            sources[`art:${item.kind}:missing`] = [...known, item.missing]
              .slice(-MISSING_URLS_KEPT)
              .join(' ')
            g.metadata = { ...g.metadata, sources }
            changed = true
          }
        }
        if (item.url && g.media[item.kind] !== item.url) {
          g.media[item.kind] = item.url
          changed = true
        }
        if (
          item.url &&
          (item.source || item.quality || g.metadata.sources?.[`art:${item.kind}:missing`])
        ) {
          const sources = { ...(g.metadata.sources ?? {}) }
          if (item.source) sources[`art:${item.kind}`] = item.source
          if (item.quality === 'small') sources[`art:${item.kind}:quality`] = 'small'
          else if (item.quality === 'full') delete sources[`art:${item.kind}:quality`]
          // Landed art outranks the memo of URLs that failed before it.
          delete sources[`art:${item.kind}:missing`]
          g.metadata = { ...g.metadata, sources }
          changed = true
        }
        if (changed && !touched.includes(item.gameId)) touched.push(item.gameId)
      }
    })
    if (touched.length && !options.quiet)
      this.events.emit('library:changed', { reason: 'metadata', gameIds: touched })
    return touched
  }

  /** Set the metadata status of many games in one transaction and one `library:changed` (an enqueue of thousands). */
  setMetadataStatusBatch(ids: string[], status: Game['metadataStatus']): void {
    const touched: string[] = []
    this.store.transaction((d) => {
      for (const id of ids) {
        const g = d.games[id]
        if (!g || g.metadataStatus === status) continue
        g.metadataStatus = status
        touched.push(id)
      }
    })
    if (touched.length)
      this.events.emit('library:changed', { reason: 'metadata', gameIds: touched })
  }

  /** Set (or clear with null) one media URL regardless of what is there. */
  setMedia(
    id: string,
    kind: Exclude<MediaKind, 'screenshot'>,
    url: string | null
  ): Game | undefined {
    const game = this.store.patch(id, (g) => {
      if (url) g.media[kind] = url
      else delete g.media[kind]
    })
    if (game) this.events.emit('library:changed', { reason: 'metadata', gameIds: [id] })
    return game
  }

  beginSession(gameId: string): ActiveSession {
    const startedAt = new Date().toISOString()
    const session = this.sessions.start(gameId, startedAt)
    this.store.patch(gameId, (g) => {
      g.lastPlayed = startedAt
      g.playCount = (g.playCount ?? 0) + 1
    })
    this.events.emit('session:started', { gameId, startedAt })
    this.events.emit('library:changed', { reason: 'session', gameIds: [gameId] })
    return { sessionId: session.id, gameId, startedAt }
  }

  /**
   * End a session. `minutes` is the tracker's measured play time (sum of poll gaps, sleep gaps discarded); without it
   * the wall-clock difference is used.
   */
  endSession(active: ActiveSession, minutes?: number): void {
    const endedAt = new Date().toISOString()
    minutes ??= Math.max(
      0,
      Math.round((Date.parse(endedAt) - Date.parse(active.startedAt)) / 60_000)
    )
    this.sessions.end(active.sessionId, endedAt, minutes)
    this.store.patch(active.gameId, (g) => {
      g.playtimeMinutes = (g.playtimeMinutes ?? 0) + minutes
    })
    this.events.emit('session:ended', {
      gameId: active.gameId,
      startedAt: active.startedAt,
      endedAt,
      minutes
    })
    this.events.emit('library:changed', { reason: 'session', gameIds: [active.gameId] })
  }

  getSessions(gameId: string): PlaySession[] {
    return this.sessions.forGame(gameId)
  }

  /** Every play session kept (this PC's and those taken from paired PCs), oldest first. */
  allSessions(): readonly PlaySession[] {
    return this.sessions.all()
  }

  /** Whether a play session of this id is (or was) kept here: the play time sync's de-duplication. */
  hasSession(id: string): boolean {
    return this.sessions.has(id)
  }

  /**
   * Play sessions played on another PC (streaming/playtime-sync.ts), each ended, for a game of this PC: stored with
   * `from` (that PC) and `syncedAt` (now), and counted in the game's play time, play count and last played. A session
   * already here (by id), of an unknown game or not ended is skipped, so the same session sent again counts once.
   * A session of a store's copy (`store`) taken by this PC's copy of that store adds no minutes: that store's account
   * total (storePlaytimeMinutes) already counts them. One `library:changed` for the batch; no `session:` events (nothing was played here). Returns how many were added.
   */
  addSyncedSessions(
    sessions: {
      id: string
      gameId: string
      startedAt: string
      endedAt: string
      minutes: number
      store?: string
    }[],
    from: string
  ): number {
    const syncedAt = new Date().toISOString()
    const added = this.sessions.add(
      sessions
        .filter((s) => s.endedAt && this.store.getGame(s.gameId))
        .map((s) => ({
          id: s.id,
          gameId: s.gameId,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          minutes: Math.max(0, Math.round(s.minutes)),
          from,
          syncedAt,
          ...(s.store ? { store: s.store } : {})
        }))
    )
    if (!added.length) return 0
    const touched = new Set<string>()
    for (const s of added) {
      this.store.patch(s.gameId, (g) => {
        if (!s.store || g.source !== s.store)
          g.playtimeMinutes = (g.playtimeMinutes ?? 0) + s.minutes
        g.playCount = (g.playCount ?? 0) + 1
        if (!g.lastPlayed || Date.parse(s.startedAt) > Date.parse(g.lastPlayed))
          g.lastPlayed = s.startedAt
      })
      touched.add(s.gameId)
    }
    this.events.emit('library:changed', { reason: 'session', gameIds: [...touched] })
    return added.length
  }

  /**
   * When games of this PC were last played on a paired PC that cannot send their sessions (streaming/recency-relay.ts:
   * a store game the host does not offer): each game's last played becomes `atMs` (this PC's clock) when that is
   * later than the one it has. Its play time and play count are not touched, and no session is kept. An unknown game
   * or a time that is none is skipped. One `library:changed` for the batch. Returns how many games changed.
   */
  setSyncedLastPlayed(entries: { id: string; atMs: number }[]): number {
    const touched: string[] = []
    for (const { id, atMs } of entries) {
      if (!Number.isFinite(atMs) || atMs <= 0) continue
      const had = this.store.getGame(id)
      if (!had) continue
      const before = had.lastPlayed ? Date.parse(had.lastPlayed) : Number.NaN
      if (Number.isFinite(before) && before >= atMs) continue
      if (
        this.store.patch(id, (g) => {
          g.lastPlayed = new Date(atMs).toISOString()
        })
      )
        touched.push(id)
    }
    if (touched.length) this.events.emit('library:changed', { reason: 'update', gameIds: touched })
    return touched.length
  }

  sourceState(id: SourceId): { lastScanAt?: string; error?: string } {
    return this.store.sourceState(id)
  }

  setSourceState(id: SourceId, state: { lastScanAt?: string; error?: string }): void {
    this.store.setSourceState(id, state)
  }
}

/**
 * The user has touched the record: a favourite, a completed mark, a hidden flag, a renamed title, custom art or a
 * preferred copy must survive an import.
 */
function hasUserState(game: Game): boolean {
  return (
    game.favorite ||
    !!game.completed ||
    !!game.user.preferredCopy ||
    // Hidden here while the store does not, or shown here while the store hides it: the user's own choice.
    game.hidden !== Boolean(game.hiddenByStore) ||
    !!game.user.titleOverride ||
    Object.values(game.user.customMedia ?? {}).some(Boolean)
  )
}

/**
 * An existing record of the source that is the same game under another id: its `extra.contentIds` (the EA
 * provider's `;`-joined list from installerdata.xml) names the owned game's content id, or both carry the same
 * `eaOfferId`. Only installed records qualify, so two owned-only records never fold into each other.
 */
function findAlias(aliases: Map<string, Game>, externalId: string, o: OwnedGame): Game | undefined {
  const offerId = typeof o.extra?.eaOfferId === 'string' ? o.extra.eaOfferId : undefined
  return (
    aliases.get(`content:${externalId}`) ?? (offerId ? aliases.get(`offer:${offerId}`) : undefined)
  )
}

/** The installed records of a source keyed by every other id they answer to (`content:<id>`, `offer:<id>`). */
function aliasIndex(games: Record<string, Game>, source: StoreSourceId): Map<string, Game> {
  const index = new Map<string, Game>()
  for (const g of Object.values(games)) {
    if (g.source !== source || !g.installed) continue
    const ids = typeof g.extra?.contentIds === 'string' ? g.extra.contentIds.split(';') : []
    for (const id of ids) if (!index.has(`content:${id}`)) index.set(`content:${id}`, g)
    if (typeof g.extra?.eaOfferId === 'string' && !index.has(`offer:${g.extra.eaOfferId}`))
      index.set(`offer:${g.extra.eaOfferId}`, g)
  }
  return index
}

/** Release date, developer and publisher from the store listing, only while no scraper has run. */
function seedMetadata(game: Game, o: OwnedGame): void {
  if (o.releaseDate && !game.metadata.releaseDate) game.metadata.releaseDate = o.releaseDate
  if (o.developer && !game.metadata.developers?.length) game.metadata.developers = [o.developer]
  if (o.publisher && !game.metadata.publishers?.length) game.metadata.publishers = [o.publisher]
}
